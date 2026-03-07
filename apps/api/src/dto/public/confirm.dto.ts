import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class ConfirmDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  // kept for explicit controller-level reject when present
  @IsOptional()
  @IsString()
  booking_id?: string;
}
