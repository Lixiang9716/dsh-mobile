// dsh:logging-exempt (transport route: hilog markers only; the canonical
// records are the parity scenario's own, delivered through the phase sink)
/**
 * ParityMockRoute — the on-device scripted model boundary of the
 * `upstream.parity` leg (ONE route on the leg's carrier, consumed by the
 * parity scenario's real LlmRuntime through the gateway httpFetch
 * primitive). The harmony twin of the iOS leg's host-side vendored mock
 * (DSH_MOCK_SEQUENCE='success tool_call_success success auth_error',
 * runtime/dsh/ci/mock-llm-server.mjs) and the Android leg's armed
 * MockLlmRoute: per-call behaviors in script order, never interpreted.
 *
 * The wire shapes are the vendored @deepseek-ai/dsh-llm-mock-server's
 * (vendor/dsh/llm-mock-server@0.1.6-alpha.2): successText 'Hello from
 * upstream' in 5-char deltas + terminal stop chunk with usage + [DONE];
 * the todo_write tool-call in TWO delta chunks split at the arguments'
 * midpoint (id 'mock-call-1') + terminal tool_calls chunk; the 401 JSON
 * error body. The parity comparator demands record-for-record identity
 * with the committed golden, so these shapes are LOAD-BEARING.
 */
import { socket } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CarrierRequest, CarrierServer } from './CarrierServer';

const TAG: string = 'dsh.app';
const SSE_TYPE: string = 'text/event-stream; charset=utf-8';
/** The scripted route's bearer key (the vendored mock's default key the
 * parity legs share) — exported so the leg's runtime.config carries the
 * SAME value the route enforces. */
export const PARITY_MOCK_KEY: string = 'mock-key-0001';
const PARITY_PATH: string = '/parity-mock/chat/completions';
const SUCCESS_TEXT: string = 'Hello from upstream';
const TOOL_NAME: string = 'todo_write';
/** The parity scenario's scripted tool arguments (the same bytes every
 * parity leg feeds its mock — run-ios-upstream-parity.sh). */
const TOOL_ARGUMENTS: string =
  '{"todos":[{"content":"Track the parity check","status":"in_progress"}]}';

export class ParityMockRoute {
  private server: CarrierServer;
  /** Next behavior index — one consume per accepted call, script order:
   * success → tool_call_success → success → auth_error. */
  private cursor: number = 0;

  constructor(server: CarrierServer) {
    this.server = server;
  }

  /** Registers the exact route on the leg's carrier (duplicate = fatal,
   * the server throws). */
  register(): void {
    this.server.register('exact', PARITY_PATH,
      (req: CarrierRequest, conn: socket.TCPSocketConnection): void => {
        this.serve(req, conn);
      });
  }

  /** The mockLlmUrl the parity leg delivers in its runtime.config — the
   * adapter appends `/chat/completions`. */
  static baseUrl(port: number): string {
    return 'http://127.0.0.1:' + port + '/parity-mock';
  }

  private serve(req: CarrierRequest, conn: socket.TCPSocketConnection): void {
    if (req.method !== 'POST') {
      this.server.respondText(conn, 405, 'text/plain', 'method not allowed');
      return;
    }
    if (req.headers['authorization'] !== 'Bearer ' + PARITY_MOCK_KEY) {
      // The vendored mock's bearer-mismatch body (ordinary 4xx, not a
      // scripted behavior — the parity script never lands here).
      const body = '{"error":{"message":"invalid mock bearer token",' +
        '"code":"invalid_api_key"}}';
      this.server.respondText(conn, 401, 'application/json', body);
      return;
    }
    const behavior: string =
      this.cursor < 4 ? this.behaviorAt(this.cursor) : 'script_exhausted';
    this.cursor = this.cursor + 1;
    hilog.info(0x0000, TAG, 'parity mock: %{public}s (call %{public}d)',
      behavior, this.cursor);
    if (behavior === 'success') {
      this.server.respondText(conn, 200, SSE_TYPE, this.successStream());
    } else if (behavior === 'tool_call_success') {
      this.server.respondText(conn, 200, SSE_TYPE, this.toolCallStream());
    } else if (behavior === 'auth_error') {
      const body = '{"error":{"message":"mock authentication failed",' +
        '"type":"mock_error","code":"invalid_api_key"}}';
      this.server.respondText(conn, 401, 'application/json', body);
    } else {
      // script_exhausted: the parity script is exactly four calls; a fifth
      // means the scenario is not the committed one — fail the wire loud.
      const body = '{"error":{"message":"mock script exhausted",' +
        '"type":"mock_error","code":"MOCK_SCRIPT_EXHAUSTED"}}';
      this.server.respondText(conn, 500, 'application/json', body);
    }
  }

  private behaviorAt(index: number): string {
    const script: string[] = ['success', 'tool_call_success', 'success',
      'auth_error'];
    return script[index];
  }

  /** The vendored `success` behavior: successText in chunkSize=5 deltas,
   * terminal stop chunk with usage (prompt 3, completion = text length),
   * [DONE]. */
  private successStream(): string {
    let sse = '';
    for (let at = 0; at < SUCCESS_TEXT.length; at += 5) {
      const chunk = SUCCESS_TEXT.substring(at, Math.min(at + 5,
        SUCCESS_TEXT.length));
      sse += 'data: {"choices":[{"index":0,"delta":{"content":"' + chunk +
        '"},"finish_reason":null}]}\n\n';
    }
    sse += 'data: {"choices":[{"index":0,"delta":{"content":""},' +
      '"finish_reason":"stop"}],"usage":{"prompt_tokens":3,' +
      '"completion_tokens":' + SUCCESS_TEXT.length + '}}\n\n';
    sse += 'data: [DONE]\n\n';
    return sse;
  }

  /** The vendored `tool_call_success` behavior: the scripted tool call in
   * TWO delta chunks (arguments split at the midpoint, id on the first),
   * terminal tool_calls chunk with usage (completion 2), [DONE]. */
  private toolCallStream(): string {
    const midpoint = Math.max(1, Math.floor(TOOL_ARGUMENTS.length / 2));
    const first: string = TOOL_ARGUMENTS.substring(0, midpoint);
    const rest: string = TOOL_ARGUMENTS.substring(midpoint);
    let sse = '';
    sse += 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,' +
      '"id":"mock-call-1","type":"function","function":{"name":"' +
      TOOL_NAME + '","arguments":' + JSON.stringify(first) + '}}]},' +
      '"finish_reason":null}]}\n\n';
    sse += 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,' +
      '"function":{"arguments":' + JSON.stringify(rest) + '}}]},' +
      '"finish_reason":null}]}\n\n';
    sse += 'data: {"choices":[{"index":0,"delta":{"content":""},' +
      '"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,' +
      '"completion_tokens":2}}\n\n';
    sse += 'data: [DONE]\n\n';
    return sse;
  }
}
