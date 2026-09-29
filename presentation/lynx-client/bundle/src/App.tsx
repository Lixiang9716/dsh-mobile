// dsh:logging-exempt (ReactLynx bundle: pure presentation, zero logging surface — E2E evidence flows through the driver, as with the web clients)
/**
 * App.tsx — the root: aurora backdrop, top bar, thread, composer, drawer.
 * The single subscription point on the bundle side is useSurface() here;
 * every child renders from props. mount-time work: install the engine
 * bridge BEFORE anything can emit an intent.
 */
import { useEffect, useState } from '@lynx-js/react';
import type { FC } from '@lynx-js/react';
import { installSurface, useSurface, emitIntent } from './bridge.js';
import { styles } from './styles.js';
import { TopBar, Drawer } from './components/Chrome.js';
import { Thread } from './components/Thread.js';
import { Composer } from './components/Composer.js';

const AuroraBackdrop = () => (
  <view style={styles.backdrop}>
    <view style={styles.blobOcean} />
    <view style={styles.blobHaze} />
    <view style={styles.blobPurple} />
  </view>
);

export const App: FC = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    installSurface();
  }, []);
  const state = useSurface();

  const closeDrawer = (): void => setDrawerOpen(false);
  const selectFromDrawer = (sessionId: string): void => {
    setDrawerOpen(false);
    emitIntent({ type: 'select-session', sessionId });
  };
  const newFromDrawer = (): void => {
    setDrawerOpen(false);
    emitIntent({ type: 'new-session' });
  };
  const drawer = drawerOpen ? (
    <Drawer
      sessions={state.sessions}
      onClose={closeDrawer}
      onSelect={selectFromDrawer}
      onNew={newFromDrawer}
    />
  ) : null;

  return (
    <view style={styles.root}>
      <AuroraBackdrop />
      <view style={styles.column}>
        <TopBar connection={state.connection} onDrawer={() => setDrawerOpen(true)} />
        <Thread state={state} />
        <Composer running={state.running} />
      </view>
      {drawer}
    </view>
  );
};
