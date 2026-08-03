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
};
