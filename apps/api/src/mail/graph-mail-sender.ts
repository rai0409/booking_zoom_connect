import { GraphClient } from "../clients/graph.client";
import { config } from "../config";
import { MailSender, MailSendInput } from "./mail-sender";

export class GraphMailSender implements MailSender {
  constructor(private readonly graph: GraphClient = new GraphClient()) {}

  async send(input: MailSendInput): Promise<void> {
    if (config.mailDriver !== "graph") {
      throw new Error(`Unsupported MAIL_DRIVER: ${config.mailDriver}`);
    }

    await this.graph.sendMail(input.m365TenantId, {
      to: input.to,
      subject: input.subject,
      body: input.body
    });
  }
}
