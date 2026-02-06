# CURL Examples for Scan Service API

## POST /battery/:sticker_id - Create a scan record

### Basic example
```bash
curl -X POST https://api.cuub.tech/battery/A201 \
  -H "Content-Type: application/json" \
  -H "manufacture_id: CUBH5A000513" \
  -d '{}'
```

### Create scan (manufacture_id optional if battery has it)
```bash
curl -X POST https://api.cuub.tech/battery/A201 \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Create scan with different sticker_id
```bash
curl -X POST https://api.cuub.tech/battery/B301 \
  -H "Content-Type: application/json" \
  -H "manufacture_id: CUBH5A000514" \
  -d '{}'
```

### Pretty-print response (with jq)
```bash
curl -X POST https://api.cuub.tech/battery/A201 \
  -H "Content-Type: application/json" \
  -H "manufacture_id: CUBH5A000513" \
  -d '{}' | jq .
```

---

## PATCH /battery/:sticker_id - Update a scan record

### Update with manufacture_id only (refreshes order_id and duration_after_rent)
```bash
curl -X PATCH https://api.cuub.tech/battery/A201 \
  -H "manufacture_id: CUBH5A000513"
```

### Update sticker_type
```bash
curl -X PATCH https://api.cuub.tech/battery/A201 \
  -H "manufacture_id: CUBH5A000513" \
  -H "sticker_type: NFC"
```

### Update multiple fields
```bash
curl -X PATCH https://api.cuub.tech/battery/A201 \
  -H "manufacture_id: CUBH5A000513" \
  -H "sticker_type: QR_CODE"
```

### Update different sticker_id
```bash
curl -X PATCH https://api.cuub.tech/battery/B301 \
  -H "manufacture_id: CUBH5A000514" \
  -H "sticker_type: NFC"
```

### Pretty-print response (with jq)
```bash
curl -X PATCH https://api.cuub.tech/battery/A201 \
  -H "manufacture_id: CUBH5A000513" \
  -H "sticker_type: NFC" | jq .
```

---

## GET /scans - List all scan records

```bash
curl https://api.cuub.tech/scans
```

### Pretty-print response
```bash
curl https://api.cuub.tech/scans | jq .
```

**Note:** This endpoint returns all scan records ordered by `scan_time` (descending).

---

## GET /battery/:sticker_id - Get battery information by sticker_id

```bash
curl https://api.cuub.tech/battery/A201
```

### Get battery info for different sticker_id
```bash
curl https://api.cuub.tech/battery/B301
```

### Pretty-print response
```bash
curl https://api.cuub.tech/battery/A201 | jq .
```

**Note:** This endpoint returns battery information including:
- `manufacture_id`
- `sticker_id`
- `startTime` (epoch timestamp)
- `returnTime` (epoch timestamp, null if not returned)
- `duration` (formatted as HH:MM:SS)
- `amountPaid` (calculated based on pricing model)

---

## Notes

### Scan Service API
- All endpoints return JSON responses
- **POST `/battery/:sticker_id`**:
  - Optional header: `manufacture_id` (required if battery has no manufacture_id in DB)
  - `sticker_type` is taken from `battery.type` in the database (header ignored)
  - Automatically fetches `order_id` and calculates `duration_after_rent` from Relink API
  - Creates a new scan record in the `scans` table
- **PATCH `/battery/:sticker_id`**:
  - Required header: `manufacture_id`
  - Optional header: `sticker_type`
  - Updates the most recent scan record for the given `sticker_id`
  - Automatically refreshes `order_id` and `duration_after_rent` from Relink API if `manufacture_id` is provided
- **GET `/scans`**:
  - Returns all scan records ordered by `scan_time` (descending)
  - Includes: `scan_id`, `sticker_id`, `order_id`, `scan_time`, `sticker_type`, `duration_after_rent`, `sizl`
- **GET `/battery/:sticker_id`**:
  - Returns battery information including `duration` and `amountPaid`
  - `duration` is calculated from `startTime` to `returnTime` (or current time if `returnTime` is null)
  - `amountPaid` follows pricing: $3 per 24 hours, max $21 for 7 days, $24 penalty after 7 days
