import { IsISO8601, IsNotEmpty, IsString } from "class-validator";

export class RescheduleBookingDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsISO8601({ strict: true })
  new_start_at!: string;

  @IsISO8601({ strict: true })
  new_end_at!: string;
}
