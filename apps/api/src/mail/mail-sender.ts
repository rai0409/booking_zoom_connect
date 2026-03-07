export type MailSendInput = {
  m365TenantId: string;
  to: string;
  subject: string;
  body: string;
};

export interface MailSender {
  send(input: MailSendInput): Promise<void>;
}
