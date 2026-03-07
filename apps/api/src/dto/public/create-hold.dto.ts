import { Type } from "class-transformer";
import {
  IsDefined,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested
} from "class-validator";

class HoldCustomerDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  company?: string;
}

export class CreateHoldDto {
  @IsOptional()
  @IsUUID()
  salesperson_id?: string;

  @IsISO8601({ strict: true })
  start_at!: string;

  @IsISO8601({ strict: true })
  end_at!: string;

  @IsOptional()
  @IsIn(["online", "offline"])
  booking_mode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public_notes?: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => HoldCustomerDto)
  customer!: HoldCustomerDto;
}
