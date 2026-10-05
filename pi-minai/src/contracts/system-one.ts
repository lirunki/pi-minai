export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  levels: string[];
};

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: {
    true: string;
    false: string;
  };
};

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export type SystemOneRequest = {
  state: string | Record<string, unknown>;
  model: string;
  questions: Record<string, Question>;
};

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};

export type NoulAnswer = {
  type: "noul";
  noul: number;
};

export type SystemOneAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type SystemOneResponse = {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

export interface SystemOneService {
  systemOne(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse>;
}
