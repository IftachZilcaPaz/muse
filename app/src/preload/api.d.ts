/** The bridge the renderer sees. Keep it narrow: the renderer never touches the filesystem or git directly. */
import type { Candidate, CheckpointResult, DetectedTool, ProjectRecord, ToolId } from "../engine/types.js";

export interface TimeMachineApi {
  home(): Promise<string>;
  detectTools(): Promise<DetectedTool[]>;
  discover(tools?: ToolId[]): Promise<Candidate[]>;
  pickFolder(): Promise<string | null>;
  track(paths: string[]): Promise<ProjectRecord[]>;
  checkpoint(slug: string, ack?: boolean): Promise<CheckpointResult>;
  listProjects(): Promise<ProjectRecord[]>;
}

declare global {
  interface Window {
    tm: TimeMachineApi;
  }
}
