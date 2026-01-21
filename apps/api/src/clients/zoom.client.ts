import { config } from "../config";

export type ZoomMeetingInput = {
  topic: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
};

export type ZoomMeetingResult = {
  meetingId: string;
  joinUrl: string;
  startUrl: string;
};

export class ZoomClient {
  async createMeeting(input: ZoomMeetingInput): Promise<ZoomMeetingResult> {
    if (config.zoomMock) {
      const token = Math.abs(hash(`${input.topic}:${input.startUtc}`));
      return {
        meetingId: `mock-${token}`,
        joinUrl: `https://zoom.example/join/${token}`,
        startUrl: `https://zoom.example/start/${token}`
      };
    }
    throw new Error("Zoom client not implemented");
  }

  async deleteMeeting(): Promise<void> {
    if (config.zoomMock) {
      return;
    }
    throw new Error("Zoom client not implemented");
  }
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h << 5) - h + value.charCodeAt(i);
    h |= 0;
  }
  return h;
}
