import { IsUUID } from "class-validator";

export class VerifyEmailDto {
  @IsUUID()
  booking_id!: string;
}
