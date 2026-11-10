/**
 * Web UI half of dsh-delete-archived-session.
 *
 * Two slot entries:
 * 1. `sidebar.workspaces.session.menu.item` — a danger-styled "Delete session"
 *    row (host MenuItemButton primitive) that appears ONLY for sessions in the
 *    registry's archived set. Clicking it closes the menu and opens the modal.
 * 2. `shell.overlay` — a RiskConfirmation modal (the host's own destructive
 *    confirmation primitive: warning icon, acknowledge checkbox, outline
 *    cancel + primary confirm). The modal lives here, not in the menu entry,
 *    because the menu unmounts its rows when it closes.
 *
 * Deletion runs over a dedicated session-free Typert Remote namespace,
 * mounted at apply time via `$mount` with hand-built src-json descriptors —
 * no open session is needed, unlike the slash-command channel. The host half
 * provides the matching service with a forged Remote-method descriptor.
 * The invoke closure is captured from the raw namespace service after the
 * mount resolves (see deleteSessionRpc below) instead of reading the dotted
 * `remote.<ns>` accessor, which Cordis only resolves for fibers injecting
 * that exact key.
 *
 * All UI comes from `@deepseek-ai/dsh-client-ui-primitives` (present in the
 * browser module table), so the dialog and menu row are pixel-identical to
 * the host's own and inherit the theme automatically.
 */
window.__ModuleLoader__.load({
  id: 'dsh-delete-archived-session',
  factory(require) {
    const React = require('react');
    const { MenuItemButton, RiskConfirmation, IconTrashOutlineRegular } =
      require('@deepseek-ai/dsh-client-ui-primitives');

    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    const MENU_ENTRY_ID = 'dsh-delete-archived-session.delete';
    const OVERLAY_SLOT = 'shell.overlay';
    const OVERLAY_ENTRY_ID = 'dsh-delete-archived-session.modal';
    const LOCALE_NS = 'delete-archived-session-ui';
    const ORDER = 500;

    const EN = {
      'menu.delete': 'Delete session',
      'modal.title': 'Delete archived session',
      'modal.description':
        'Permanently delete {id}? Its stored log, cache record, and sidebar entries will be removed. This cannot be undone.',
      'modal.acknowledge': 'I understand this cannot be undone',
      'modal.cancel': 'Cancel',
      'modal.confirm': 'Delete',
      'modal.deleting': 'Deleting…',
      'modal.close': 'Close',
      'modal.failed': 'Delete failed: {message}',
    };
    const ZH = {
      'menu.delete': '删除会话',
      'modal.title': '删除已归档会话',
      'modal.description': '永久删除 {id}？其日志文件、缓存记录和侧栏条目都将被移除，此操作不可恢复。',
      'modal.acknowledge': '我了解此操作不可恢复',
      'modal.cancel': '取消',
      'modal.confirm': '删除',
      'modal.deleting': '删除中…',
      'modal.close': '关闭',
      'modal.failed': '删除失败：{message}',
    };

    // Module-level modal target. The menu row unmounts when the menu closes,
    // so the pending target must outlive it; the overlay entry renders from
    // this store via useSyncExternalStore.
    let modalState = { sessionId: null };
    const modalListeners = new Set();
    const emitModal = () => {
      for (const listener of modalListeners) listener();
    };
    const openModal = (sessionId) => {
      modalState = { sessionId };
      emitModal();
    };
    const closeModal = () => {
      if (modalState.sessionId === null) return;
      modalState = { sessionId: null };
      emitModal();
    };
    const subscribeModal = (listener) => {
      modalListeners.add(listener);
      return () => modalListeners.delete(listener);
    };
    const getModalSnapshot = () => modalState;

    // deleteSession invoke closure, captured after $mount resolves.
    // `remote.deleteArchivedSession` (dotted accessor) is deliberately NOT
    // used: the namespace service is provided by a sibling fiber under the
    // gateway, and the Cordis ctx proxy refuses dotted reads from any fiber
    // that does not inject that exact key ("cannot get property ... without
    // inject") — which would deadlock us, since our own effect performs the
    // mount. The raw `namespaces` Map is reachable through the traceable
    // proxy (plain own field), and the namespace service's method getter
    // returns a closure bound to the namespace fiber's own ctx, safe to call
    // from React handlers.
    let deleteSessionRpc = null;

    // Hand-built $mount contribution replicating what createTypertRemoteInfo
    // generates for the host's src-mode service. Parameter codecs must claim
    // mode 'strict' (client-side validateContribution checks the mode string
    // only; create()/parse() are never called on this path). Results ride as
    // src-json — the gateway passes JSON-clean values through untouched.
    const strictStringCodec = {
      mode: 'strict',
      typeSymbol: 'string',
      jsonSchema: { type: 'string' },
      create: () => ({ parse: (value) => value }),
    };
    const contribution = {
      package: 'dsh-delete-archived-session',
      descriptors: [
        {
          id: 'dsh-delete-archived-session#deleteArchivedSession/listArchived',
          service: 'deleteArchivedSession',
          namespace: 'deleteArchivedSession',
          method: 'listArchived',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'src-json' },
        },
        {
          id: 'dsh-delete-archived-session#deleteArchivedSession/deleteSession',
          service: 'deleteArchivedSession',
          namespace: 'deleteArchivedSession',
          method: 'deleteSession',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'sessionId', wire: 'sessionId', source: 'json', codec: strictStringCodec },
          ],
          result: { mode: 'src-json' },
        },
      ],
    };

    return {
      inject: ['slots', 'locale', 'workspaces', 'remote'],
      apply(ctx) {
        // Cordis resolves ctx properties against the ACTIVE fiber's inject
        // scope; components and handlers run inside the slot owner's fiber —
        // capture every service here, in our own apply fiber.
        const locale = ctx.locale;
        const workspaces = ctx.workspaces;
        const remote = ctx.remote;

        const t = locale.bind(LOCALE_NS);
        const fill = (key, name, value) => t(key).replace(`{${name}}`, value);

        ctx.effect(() => {
          const disposeEn = locale.register(LOCALE_NS, 'en', EN);
          const disposeZh = locale.register(LOCALE_NS, 'zh', ZH);
          return () => {
            disposeEn();
            disposeZh();
          };
        });

        // Mount the session-free remote namespace. $mount must run inside a
        // fiber; its installation is effect-tracked, so fiber disposal (page
        // teardown / bundle unload) unwinds it.
        ctx.effect(async () => {
          const dispose = await remote.$mount(contribution);
          const namespace = remote.namespaces.get('deleteArchivedSession');
          const service = namespace && namespace.service;
          deleteSessionRpc =
            service && typeof service.deleteSession === 'function' ? service.deleteSession : null;
          return () => {
            deleteSessionRpc = null;
            if (typeof dispose === 'function') dispose();
          };
        });

        const list = workspaces.list;
        const subscribeArchived = (onChange) => list.subscribe(onChange);

        /** Menu row: visible only for archived sessions; opens the modal. */
        function DeleteArchivedSessionItem({ sessionId, useMenuOpenState }) {
          const [, setMenuOpen] = useMenuOpenState();
          const isArchived = React.useSyncExternalStore(subscribeArchived, () =>
            list.getSnapshot().archivedSessionIds.includes(sessionId)
          );
          if (!isArchived) return null;
          return React.createElement(
            MenuItemButton,
            {
              separatorBefore: true,
              danger: true,
              icon: React.createElement(IconTrashOutlineRegular, { size: 14 }),
              onSelect: () => {
                setMenuOpen(false);
                openModal(sessionId);
              },
            },
            t('menu.delete')
          );
        }

        /** The confirmation dialog body; keyed by sessionId so state resets. */
        function DeleteSessionDialog({ sessionId }) {
          const [acknowledged, setAcknowledged] = React.useState(false);
          const [busy, setBusy] = React.useState(false);
          const [error, setError] = React.useState(null);

          const close = () => {
            if (busy) return;
            closeModal();
          };

          const onConfirm = () => {
            setBusy(true);
            setError(null);
            const describeFailure = (failure) =>
              String((failure && (failure.message || failure.code)) || 'remote failure');
            void (async () => {
              try {
                const rpc = deleteSessionRpc;
                if (typeof rpc !== 'function') {
                  throw new Error('deleteArchivedSession remote is not mounted');
                }
                const result = await rpc(sessionId);
                if (!result.ok) {
                  setError(describeFailure(result.error));
                  setBusy(false);
                  return;
                }
                const value = result.value;
                if (!value || value.ok !== true) {
                  setError(value && value.detail ? `${value.reason}: ${value.detail}` : 'delete rejected');
                  setBusy(false);
                  return;
                }
                closeModal(); // success: row vanishes via the workspace watch
              } catch (err) {
                setError(String((err && err.message) || err));
                setBusy(false);
              }
            })();
          };

          return React.createElement(RiskConfirmation, {
            open: true,
            title: t('modal.title'),
            description: error
              ? fill('modal.failed', 'message', error)
              : fill('modal.description', 'id', sessionId),
            acknowledgeLabel: t('modal.acknowledge'),
            cancelLabel: t('modal.cancel'),
            closeLabel: t('modal.close'),
            confirmLabel: busy ? t('modal.deleting') : t('modal.confirm'),
            acknowledged,
            disabled: busy,
            onAcknowledgedChange: setAcknowledged,
            onCancel: close,
            onConfirm,
          });
        }

        /** Overlay entry: renders the dialog while a target is pending. */
        function DeleteSessionOverlay() {
          const { sessionId } = React.useSyncExternalStore(subscribeModal, getModalSnapshot);
          if (sessionId === null) return null;
          return React.createElement(DeleteSessionDialog, { key: sessionId, sessionId });
        }

        ctx.slots.inject(MENU_SLOT, () =>
          ctx.slots.register(
            { name: MENU_SLOT, id: MENU_ENTRY_ID, order: ORDER },
            DeleteArchivedSessionItem
          )
        );
        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register({ name: OVERLAY_SLOT, id: OVERLAY_ENTRY_ID }, DeleteSessionOverlay)
        );
      },
    };
  },
});
