export type LiaConversationMessage = {
  role: 'user' | 'assistant';
  text: string;
};

export type LiaConversationController = {
  message: string;
  messages: LiaConversationMessage[];
  pending: boolean;
  open: boolean;
  setMessage: (message: string) => void;
  submit: () => void;
  openPanel: () => void;
  closePanel: () => void;
  voice: {
    state: 'unsupported' | 'idle' | 'starting' | 'listening' | 'transcript_ready' | 'error' | 'speaking';
    recognitionSupported: boolean;
    synthesisSupported: boolean;
    interimTranscript: string;
    error: string | null;
    start: () => void;
    stop: () => void;
    cancelSpeech: () => void;
  };
};
