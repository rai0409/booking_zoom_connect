# Public Booking MVP Runbook

## URLs
- API health: http://localhost:4000/health
- API ready:  http://localhost:4000/ready
- UI:         http://localhost:3000/public/acme

## MVP done criteria
1) UI or curl で hold -> verify-email -> confirm が成功する
2) DBで confirmed を直接確認できる

## DB check
```bash
cd apps/api
source .env
psql "${DATABASE_URL%%\?schema=*}" -c \
"select id, status, start_at_utc, end_at_utc from bookings order by created_at desc limit 5;"
```
