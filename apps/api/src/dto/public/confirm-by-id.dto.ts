import { IsNotEmpty, IsString, IsUUID } from "class-validator";

export class ConfirmByIdDto {
  @IsUUID()
  booking_id!: string;

  @IsString()
  @IsNotEmpty()
  token!: string;
}
