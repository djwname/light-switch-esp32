export interface AsrMessage {
  header: {
    action?: "run-task" | "finish-task";
    event?:
      | "task-started"
      | "result-generated"
      | "task-finished"
      | "task-failed";
    task_id: string;
    streaming?: "duplex";
    error_code?: string;
    error_message?: string;
  };
  payload?: {
    task_group?: "audio";
    task?: "asr";
    function?: "recognition";
    model?: string;
    parameters?: {
      format: "pcm";
      sample_rate: number;
      heartbeat?: boolean;
      // 可选：vocabulary_id?: string; 等
    };
    input?: Record<string, unknown>;
    output?: {
      sentence: {
        text: string;
        sentence_end: boolean;
        begin_time: number;
        end_time: number;
      };
    };
    usage?: {
      duration: number;
    };
  };
}
