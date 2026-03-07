import { IsOptional, IsString, IsUUID, Matches } from "class-validator";

export class AvailabilityQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "date must be in YYYY-MM-DD format"
  })
  date!: string;

  @IsOptional()
  @IsUUID()
  salesperson?: string;
}
