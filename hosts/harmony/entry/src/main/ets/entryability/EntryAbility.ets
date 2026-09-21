/*
 * EntryAbility — standard stage-model entry point; the spike runs from the
 * Index page (aboutToAppear) so the verdict Text is on screen when the
 * scenario finishes. The M5 binding phase adds the lifecycle edges: app
 * foreground/background drive the `app.state` event channel, and a
 * notification tap (wantAgent parameters) drives `notify.response` — both
 * delivered onto the runtime queue via HostPhase (ARCHITECTURE.md §6).
 * ON CREATE it also parks the launch-selected E2E leg (`--ps dsh.e2e.leg`,
 * the HarmonyOS twin of the Android host's `--ez dsh.llm true`) for the
 * page's aboutToAppear — harmony has no scenario list to append to.
 */
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { E2eLeg } from '../model/E2eLeg';
import { HostPhase } from '../model/HostPhase';

const DOMAIN: number = 0x0000;
const TAG: string = 'dsh.app';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'EntryAbility onCreate');
    // The page reads this before its first render (onCreate precedes
    // onWindowStageCreate → loadContent). A leg name, never a secret.
    const leg = want.parameters?.['dsh.e2e.leg'];
    if (typeof leg === 'string' && leg.length > 0) {
      E2eLeg.set(leg);
      hilog.info(DOMAIN, TAG, 'leg %{public}s selected at launch', leg);
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'EntryAbility onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'EntryAbility onWindowStageCreate');
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(err) ?? '');
        return;
      }
      hilog.info(DOMAIN, TAG, '%{public}s', 'Index loaded');
    });
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'EntryAbility onNewWant');
    const params = want.parameters;
    if (params === undefined) {
      return;
    }
    const notifyId = params.notifyId;
    if (typeof notifyId === 'string' && notifyId.length > 0) {
      HostPhase.getInstance().onNotifyResponse(notifyId);
    }
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'EntryAbility onForeground');
    HostPhase.getInstance().onAppState('foreground');
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'EntryAbility onBackground');
    HostPhase.getInstance().onAppState('background');
  }
}
