/** Structural shapes of the fold's view state (mirrors shared/fold.js —
 * the fold is JS; these are the presentation-side views of it). */

export interface FoldItem {
  kind: string;
  text?: string;
  markdown?: string;
  interrupted?: boolean;
  name?: string;
  args?: string;
  status?: string;
  output?: string;
  callId?: string;
  files?: Array<{ path: string; description?: string }>;
  label?: string;
  types?: string[];
}

export interface TailTool {
  id: string;
  name: string;
  args: string;
}

export interface Tail {
  turn: number;
  step: number;
  attemptId: string;
  text: string;
  reasoning: string;
  streaming: boolean;
  tools: TailTool[];
}

export interface SessionRow {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
}
