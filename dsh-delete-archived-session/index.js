/**
 * Delete archived sessions.
 *
 * One operation, one implementation: `deleteArchivedSession` removes every
 * durable trace of an ARCHIVED session — its stored JSONL log directory under
 * the sessions root, its projection-cache record, and its workspace-registry
 * bookkeeping (the workspace `sessionIds` slot and the `archivedSessionIds`
 * entry). Only sessions currently listed in
 * `ctx.workspaceRegistry.archivedSessionIds` may be deleted; live or
 * never-archived ids are rejected, so the registry stays the authority on
 * what is safe to erase.
 *
 * Failure ordering is deliberate: on-disk artifacts are removed FIRST, and
 * the registry is only mutated after the destructive file work succeeds. A
 * failed file delete therefore leaves the session still archived (retryable)
 * instead of unregistering a session whose log survives on disk.
 *
 * This bundle deliberately imports nothing but Node builtins: a linked
 * profile bundle resolves bare imports from its own directory, where no
 * `@deepseek-ai/*` package exists. The tool definition is written in raw
 * registry form (the same shape `defineTool` compiles to), and the deployment
 * roots arrive through the Loader patch config (`!!js dshHomePath(...)`),
 * with an env-based fallback.
 *
 * @module dsh-delete-archived-session
 */
import { readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'delete-archived-session';
export const inject = ['tools', 'commands', 'workspaceRegistry', 'sessions', 'sessionPersistence'];

/**
 * Mirror of the JSONL backend's injective path-segment encoding: characters
 * outside `[A-Za-z0-9._-]` (and `~` itself) become `~XXXX` with the uppercase
 * hex code unit. For real `session-<uuid>` ids this is the identity, but the
 * general form keeps derived paths inside one directory level no matter what
 * an id looks like.
 * @param {string} raw - the session id.
 * @returns {string} the encoded single-segment directory/file name.
 */
function encodeSegment(raw) {
  let out = '';
  for (const ch of raw) {
    out += /[A-Za-z0-9._-]/.test(ch)
      ? ch
      : '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * Resolve the deployment roots: prefer the Loader-composed config values,
 * fall back to `$DSH_HOME` (or `~/.dsh`) with the same layout the shipped
 * composition uses.
 * @param {{ sessionsRoot?: string, projCacheDir?: string }} config - row config.
 */
function resolveRoots(config) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return {
    sessionsRoot: config?.sessionsRoot || join(home, 'sessions'),
    projCacheDir: config?.projCacheDir || join(home, 'storages', 'session_projcache', 'sessions'),
  };
}

/**
 * Format archived-session rows as human-readable lines, shared by the tool
 * render and the slash command so both callers report identically.
 * @param {Array<object>} archived - rows from `listArchived`.
 * @returns {string[]} one bullet line per row.
 */
function formatArchivedRows(archived) {
  return archived.map((row) => {
    const size = row.sizeBytes != null ? `, ${row.sizeBytes} bytes` : '';
    const events = row.eventCount != null ? `, ${row.eventCount} events` : '';
    const cwd = row.cwd ? `, cwd ${row.cwd}` : '';
    const missing = row.logFound === false ? ' (stored log missing)' : row.statError ? ' (stat failed)' : '';
    return `- ${row.sessionId}${cwd}${events}${size}${missing}`;
  });
}

/**
 * Format one successful delete result as a human-readable sentence, shared
 * by the tool render and the slash command.
 * @param {{ sessionId: string, deletedDirs: string[], cacheRecordDeleted: boolean, stillLoaded?: boolean }} deleted - the delete summary.
 * @returns {string} the report line.
 */
function formatDeleted(deleted) {
  return `Deleted archived session ${deleted.sessionId}: removed ${deleted.deletedDirs.length} log director${deleted.deletedDirs.length === 1 ? 'y' : 'ies'}${deleted.deletedDirs.length ? ` (${deleted.deletedDirs.join(', ')})` : ''}, projection-cache record ${deleted.cacheRecordDeleted ? 'removed' : 'not found or not removed'}, and all workspace-registry entries.${deleted.stillLoaded ? ' The session was still loaded in memory (idle; archived sessions cannot run steps) — its in-memory copy lingers until the host restarts, but nothing is written back.' : ''}`;
}

/**
 * Session-free Remote face for the Web UI.
 *
 * The gateway discovers Remote methods in "src mode": it scans every provided
 * service for a `typertRemote` binding plus the versioned Remote-method
 * descriptor the `@Remote` decorator would have recorded, then derives the
 * wire contract from the prototype signatures (parameter codecs come out as
 * `src-json`, i.e. plain-JSON checks — no zod, no registry entry needed).
 * Both artifacts are plain frozen data, so the class forges them directly
 * instead of importing `@deepseek-ai/dsh-typert-protocol` (which a linked
 * bundle cannot resolve). Constraints that follow from the gateway's
 * signature parser: methods live on the PROTOTYPE with simple identifier
 * parameters (no destructuring/defaults/rest), and results must be
 * JSON-clean.
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

class DeleteArchivedSessionApi {
  constructor(deps) {
    this.deps = deps;
  }

  listArchived() {
    return this.deps.list();
  }

  deleteSession(sessionId) {
    return this.deps.del(sessionId);
  }
}

Object.defineProperty(DeleteArchivedSessionApi.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'listArchived', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'deleteSession', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
});

/**
 * Register the `delete_archived_session` tool on `ctx.tools`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registrant context.
 * @param {{ sessionsRoot?: string, projCacheDir?: string }} config - deployment roots.
 */
export function apply(ctx, config) {
  const { sessionsRoot, projCacheDir } = resolveRoots(config);

  /**
   * List every archived session with whatever durable metadata is cheap to
   * read (persistence stat), so a caller can pick an id to delete.
   */
  async function listArchived() {
    const archived = [];
    for (const sessionId of ctx.workspaceRegistry.archivedSessionIds) {
      const row = { sessionId };
      try {
        const snapshot = await ctx.sessionPersistence.stat(sessionId);
        if (snapshot) {
          if (snapshot.header?.cwd != null) row.cwd = snapshot.header.cwd;
          if (snapshot.eventCount != null) row.eventCount = snapshot.eventCount;
          if (snapshot.sizeBytes != null) row.sizeBytes = snapshot.sizeBytes;
        } else {
          row.logFound = false;
        }
      } catch {
        // A broken or unreadable stat must not hide the row: the id is still
        // archived and still deletable.
        row.statError = true;
      }
      archived.push(row);
    }
    return { ok: true, action: 'list', archived };
  }

  /**
   * Delete one archived session everywhere. See the module header for the
   * failure-ordering contract.
   * @param {string} sessionId - an id present in `archivedSessionIds`.
   */
  async function deleteArchivedSession(sessionId) {
    const registry = ctx.workspaceRegistry;
    if (!registry.archivedSessionIds.includes(sessionId)) {
      return {
        ok: false,
        action: 'delete',
        reason: 'NOT_ARCHIVED',
        detail: `Session ${sessionId} is not in the archived list; only archived sessions can be deleted. Use action="list" to see them.`,
      };
    }
    // A loaded archived session is idle by design: the controller's
    // ArchivedSessionGate rejects every model step for archived lineages, and
    // archive-admission events already stopped its running work. So a loaded
    // entry does not block deletion — flush its buffered events first (so no
    // later flush can resurrect the log directory), delete, and flag the
    // result. The in-memory entry survives until its owner fiber disposes or
    // the host restarts; nothing writes it back.
    let stillLoaded = false;
    const loaded = ctx.sessions?.get(sessionId);
    if (loaded !== undefined) {
      stillLoaded = true;
      try {
        await ctx.sessions.flush(loaded);
      } catch {
        // Flush failure is not fatal: the archive gate keeps the session
        // silent, so at worst a stale buffer is dropped with the directory.
      }
    }

    // 1. Remove the stored log directory. The cwd-to-projectKey mapping is
    //    not reproduced; every project directory is scanned for the encoded
    //    id instead, which also cleans up logs whose project moved.
    const encoded = encodeSegment(sessionId);
    const deletedDirs = [];
    let projectEntries = [];
    try {
      projectEntries = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      projectEntries = []; // missing root: nothing on disk to delete
    }
    for (const entry of projectEntries) {
      if (!entry.isDirectory()) continue;
      const dir = join(sessionsRoot, entry.name, encoded);
      try {
        await rm(dir, { recursive: true });
        deletedDirs.push(dir);
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        return {
          ok: false,
          action: 'delete',
          reason: 'DELETE_FAILED',
          detail: `Could not delete ${dir}: ${err?.message ?? err}. The session is still archived; nothing was unregistered.`,
        };
      }
    }

    // 2. Best-effort projection-cache record removal. The cache is fail-soft
    //    by design (a stale row is never served for a deleted log), so a
    //    failure here must not block the delete.
    let cacheRecordDeleted = false;
    try {
      await unlink(join(projCacheDir, `${encoded}.json`));
      cacheRecordDeleted = true;
    } catch {
      cacheRecordDeleted = false;
    }

    // 3. Registry bookkeeping last: detach the session from every workspace
    //    that still accounts for it, then drop the archived-list entry.
    for (const workspace of registry.list()) {
      if (workspace.sessionIds.includes(sessionId)) workspace.detachSession(sessionId);
    }
    registry.unarchiveSession(sessionId);

    // 4. If the deleted session was still loaded (possibly open in a client),
    //    broadcast the controller's removal event so clients can flag/close it
    //    without waiting for the owner fiber to dispose. Best effort: the
    //    event belongs to sessionController's remote-event vocabulary and
    //    relaying it from here is harmless when nobody listens.
    if (stillLoaded) {
      try {
        ctx.emit('api-session/removed', sessionId);
      } catch {
        // No subscriber or relay refused — the sidebar already dropped the row.
      }
    }

    return {
      ok: true,
      action: 'delete',
      deleted: { sessionId, deletedDirs, cacheRecordDeleted, stillLoaded },
    };
  }

  ctx.tools.register({
    name: 'delete_archived_session',
    description:
      'List or permanently delete ARCHIVED sessions. action="list" returns every archived session id with its stored-log metadata; action="delete" removes one archived session everywhere: its stored log directory, its projection-cache record, and its workspace-registry entries. Only ids from the archived list are accepted; live or non-archived sessions are rejected. Deletion is irreversible — confirm the exact session id with the user first.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'delete'],
          description: '"list" to enumerate archived sessions, "delete" to remove one.',
        },
        sessionId: {
          type: 'string',
          description: 'The archived session id to delete (required when action="delete"), e.g. session-4315b8c4-a976-42d2-91c7-c34125a1d06c.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string', enum: ['list', 'delete'] },
          reason: { type: 'string', description: 'Failure code: NOT_ARCHIVED | DELETE_FAILED | BAD_ARGS.' },
          detail: { type: 'string' },
          archived: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['sessionId'],
              properties: {
                sessionId: { type: 'string' },
                cwd: { type: 'string', description: 'Stored-log working directory, when known.' },
                eventCount: { type: 'integer', description: 'Stored event count, when known.' },
                sizeBytes: { type: 'integer', description: 'Stored log size in bytes, when known.' },
                logFound: { type: 'boolean' },
                statError: { type: 'boolean' },
              },
            },
          },
          deleted: {
            type: 'object',
            additionalProperties: false,
            required: ['sessionId', 'deletedDirs', 'cacheRecordDeleted'],
            properties: {
              sessionId: { type: 'string' },
              deletedDirs: { type: 'array', items: { type: 'string' } },
              cacheRecordDeleted: { type: 'boolean' },
              stillLoaded: { type: 'boolean', description: 'True when the session was still loaded in host memory (flushed before deletion; idle by the archive gate).' },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `delete_archived_session failed (${value.reason}): ${value.detail ?? 'no detail'}` }];
        if (value.action === 'list') {
          const rows = formatArchivedRows(value.archived ?? []);
          return [{
            type: 'text',
            text: rows.length
              ? `${rows.length} archived session(s):\n${rows.join('\n')}`
              : 'No archived sessions.',
          }];
        }
        return [{ type: 'text', text: formatDeleted(value.deleted) }];
      },
    },
    async execute(args) {
      const action = args?.action;
      if (action === 'list') return listArchived();
      if (action === 'delete') {
        if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
          return {
            ok: false,
            action: 'delete',
            reason: 'BAD_ARGS',
            detail: 'action="delete" requires a non-empty sessionId.',
          };
        }
        return deleteArchivedSession(args.sessionId);
      }
      return {
        ok: false,
        action: 'list',
        reason: 'BAD_ARGS',
        detail: `Unknown action ${JSON.stringify(action)}; use "list" or "delete".`,
      };
    },
    isConcurrencySafe: (args) => args?.action === 'list',
    presentCall: (args) => ({
      card: 'generic',
      title: args?.action === 'list' ? 'List archived sessions' : `Delete archived session ${args?.sessionId ?? ''}`.trim(),
      kind: 'other',
      rawInput: args,
    }),
  });

  /**
   * The same operation as a human slash command. The Web UI menu item runs it
   * through `ctx.remote.commands.execute(...)`; users can also type it in the
   * composer. Execution records `command/run` + `command/done` events into the
   * executing session's log, which doubles as the audit trail of every
   * UI-triggered delete.
   */
  ctx.commands.register({
    name: 'delete-archived-session',
    description: 'Permanently delete one archived session, or list archived sessions with "list".',
    input: { hint: '<session-id> | list' },
    async handler(invocation) {
      const raw = (invocation.rawInput ?? '').trim();
      const tokens = raw.length === 0 ? [] : raw.split(/\s+/);
      if (tokens.length === 0) {
        return { kind: 'error', text: 'Usage: /delete-archived-session <session-id> | list' };
      }
      if (tokens.length > 1) {
        return { kind: 'error', text: `Expected exactly one argument, got ${tokens.length}. Usage: /delete-archived-session <session-id> | list` };
      }
      const arg = tokens[0];
      if (arg === 'list') {
        const value = await listArchived();
        const rows = formatArchivedRows(value.archived);
        return {
          kind: 'success',
          text: rows.length ? `${rows.length} archived session(s):\n${rows.join('\n')}` : 'No archived sessions.',
        };
      }
      if (invocation.agent?.id === arg) {
        return {
          kind: 'error',
          text: `Refusing to delete ${arg}: this command executes inside that session, and its log would be removed mid-run. Run it from another session.`,
        };
      }
      const value = await deleteArchivedSession(arg);
      if (!value.ok) return { kind: 'error', text: `${value.reason}: ${value.detail}` };
      return { kind: 'success', text: formatDeleted(value.deleted) };
    },
  });

  /**
   * Provide the Remote face so the Web UI can delete WITHOUT routing through
   * any session (the slash-command channel needs a live agent to execute in).
   * `ctx.provide` is whole-tree visible and lives as long as this fiber; the
   * gateway re-reads its src claims on the `internal/service` notification, so
   * enable/disable of this bundle adds/removes the endpoints automatically.
   */
  const api = new DeleteArchivedSessionApi({ list: listArchived, del: deleteArchivedSession });
  Object.defineProperty(api, 'typertRemote', {
    value: Object.freeze({
      service: api,
      serviceKey: 'deleteArchivedSession',
      namespace: 'deleteArchivedSession',
    }),
  });
  ctx.provide('deleteArchivedSession', api);
}
