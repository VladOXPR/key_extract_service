# CUUB API Documentation

Base URL: `https://api.cuub.tech`

---

## Health

### 1. Health check

Check service health and availability.

```bash
curl -X GET https://api.cuub.tech/health
```

**Expected response**

```json
{
  "status": "ok",
  "service": "energo-token-extractor",
  "timestamp": "2026-02-06T19:41:35.755Z"
}
```

---

## Users

### 2. Fetch a list of all users

```bash
curl -X GET https://api.cuub.tech/users
```

**Expected response**

```json
{
  "success": true,
  "data": [
    {
      "id": "{id}",
      "username": "SilasMed",
      "type": "HOST",
      "created_at": "2026-01-21T22:50:13.388Z",
      "updated_at": "2026-01-21T22:50:13.388Z",
      "stations": ["{station_id}"]
    }
  ],
  "count": 1
}
```

### 3. Fetch a single user by ID

```bash
curl -X GET https://api.cuub.tech/users/{id}
```

**Expected response**

```json
{
  "success": true,
  "data": {
    "id": "{id}",
    "username": "SilasMed",
    "type": "HOST",
    "created_at": "2026-01-21T22:50:13.388Z",
    "updated_at": "2026-01-21T22:50:13.388Z",
    "stations": ["{station_id}"]
  }
}
```

### 4. Create a new user

```bash
curl -X POST https://api.cuub.tech/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "NewUser",
    "type": "HOST",
    "station_ids": ["{station_id}"]
  }'
```

**Body fields**

- `username` (required): Username
- `type` (optional): `HOST`, `DISTRIBUTOR`, or `ADMIN`. Default: `HOST`
- `station_id` (optional): Single station ID
- `station_ids` (optional): Array of station IDs

**Expected response**

```json
{
  "success": true,
  "data": {
    "id": "{id}",
    "username": "NewUser",
    "type": "HOST",
    "created_at": "2026-01-21T22:50:13.388Z",
    "updated_at": "2026-01-21T22:50:13.388Z",
    "stations": ["{station_id}"]
  },
  "message": "User created successfully"
}
```

### 5. Update a user

```bash
curl -X PATCH https://api.cuub.tech/users/{id} \
  -H "Content-Type: application/json" \
  -d '{
    "username": "UpdatedUser",
    "type": "DISTRIBUTOR",
    "station_ids": ["{station_id}"]
  }'
```

**Expected response**

```json
{
  "success": true,
  "data": {
    "id": "{id}",
    "username": "UpdatedUser",
    "type": "DISTRIBUTOR",
    "created_at": "2026-01-21T22:50:13.388Z",
    "updated_at": "2026-02-06T19:41:35.755Z",
    "stations": ["{station_id}"]
  },
  "message": "User updated successfully"
}
```

### 6. Delete a user

```bash
curl -X DELETE https://api.cuub.tech/users/{id}
```

**Expected response**

```json
{
  "success": true,
  "message": "User deleted successfully",
  "data": {
    "id": "{id}",
    "username": "SilasMed",
    "type": "HOST"
  }
}
```

---

## Stations

### 7. Fetch a list of all stations

```bash
curl -X GET https://api.cuub.tech/stations
```

**Expected response**

```json
{
  "success": true,
  "data": [
    {
      "id": "{station_id}",
      "title": "Station Name",
      "latitude": 40.7128,
      "longitude": -74.006,
      "updated_at": "2026-01-21T22:50:13.388Z",
      "address": null,
      "screen_id": null,
      "sim_id": null,
      "filled_slots": 4,
      "open_slots": 2
    }
  ],
  "count": 1
}
```

### 8. Fetch a single station by ID

```bash
curl -X GET https://api.cuub.tech/stations/{id}
```

**Expected response**

```json
{
  "success": true,
  "data": {
    "id": "{station_id}",
    "title": "Station Name",
    "latitude": 40.7128,
    "longitude": -74.006,
    "updated_at": "2026-01-21T22:50:13.388Z",
    "address": null,
    "screen_id": null,
    "sim_id": null,
    "filled_slots": 4,
    "open_slots": 2
  }
}
```

### 9. Export stations as CSV

```bash
curl -X GET https://api.cuub.tech/stations/export -o stations.csv
```

**Expected response**

Returns a CSV file download with columns: `id`, `title`, `latitude`, `longitude`, `updated_at`, `address`, `screen_id`, `sim_id`, `filled_slots`, `open_slots`.

### 10. Create a new station

```bash
curl -X POST https://api.cuub.tech/stations \
  -H "Content-Type: application/json" \
  -d '{
    "id": "STATION001",
    "title": "Main Street Station",
    "latitude": 40.7128,
    "longitude": -74.006
  }'
```

**Expected response**

```json
{
  "success": true,
  "data": {
    "id": "STATION001",
    "title": "Main Street Station",
    "latitude": 40.7128,
    "longitude": -74.006,
    "updated_at": "2026-02-06T19:41:35.755Z"
  },
  "message": "Station created successfully"
}
```

### 11. Update a station

```bash
curl -X PATCH https://api.cuub.tech/stations/{id} \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Updated Station Name",
    "latitude": 40.75,
    "longitude": -74.01
  }'
```

**Expected response**

```json
{
  "success": true,
  "data": {
    "id": "{station_id}",
    "title": "Updated Station Name",
    "latitude": 40.75,
    "longitude": -74.01,
    "updated_at": "2026-02-06T19:41:35.755Z"
  },
  "message": "Station updated successfully"
}
```

### 12. Delete a station

```bash
curl -X DELETE https://api.cuub.tech/stations/{id}
```

**Expected response**

```json
{
  "success": true,
  "message": "Station deleted successfully",
  "data": {
    "id": "{station_id}",
    "title": "Station Name",
    "latitude": 40.7128,
    "longitude": -74.006
  }
}
```

---

## Battery & Scans

### 13. Fetch battery information by sticker ID

```bash
curl -X GET https://api.cuub.tech/battery/{sticker_id}
```

**Expected response**

```json
{
  "success": true,
  "data": {
    "manufacture_id": "CUBH5A000513",
    "sticker_id": "A201",
    "startTime": "1736188800000",
    "returnTime": "1736275200000",
    "duration": "18:40:00",
    "amountPaid": 6
  }
}
```

### 14. Create a scan record (POST)

Records a scan for a battery. `sticker_type` is taken from `battery.type` in the database.

```bash
curl -X POST https://api.cuub.tech/battery/{sticker_id} \
  -H "Content-Type: application/json" \
  -H "manufacture_id: CUBH5A000513" \
  -d '{}'
```

**Headers**

- `manufacture_id` (optional): Required only if battery has no `manufacture_id` in DB

**Expected response**

```json
{
  "success": true,
  "data": {
    "scan_id": "125",
    "sticker_id": "A201",
    "order_id": null,
    "scan_time": "2026-02-06T19:41:35.755Z",
    "sticker_type": "Blue",
    "duration_after_rent": null,
    "sizl": true
  }
}
```

### 15. Update a scan record (PATCH)

Updates the most recent scan for the given sticker ID.

```bash
curl -X PATCH https://api.cuub.tech/battery/{sticker_id} \
  -H "manufacture_id: CUBH5A000513" \
  -H "sticker_type: NFC" \
  -H "Content-Type: application/json" \
  -d '{"sizl": true}'
```

**Headers**

- `manufacture_id` (required)
- `sticker_type` (optional)

**Body**

- `sizl` (optional): Boolean

**Expected response**

```json
{
  "success": true,
  "data": {
    "scan_id": "125",
    "sticker_id": "A201",
    "order_id": null,
    "scan_time": "2026-02-06T19:41:35.755Z",
    "sticker_type": "NFC",
    "duration_after_rent": null,
    "sizl": true
  }
}
```

### 16. Fetch all scan records

```bash
curl -X GET https://api.cuub.tech/scans
```

**Expected response**

```json
{
  "success": true,
  "data": [
    {
      "scan_id": "125",
      "sticker_id": "A201",
      "order_id": null,
      "scan_time": "2026-02-06T19:41:35.755Z",
      "sticker_type": "Blue",
      "duration_after_rent": null,
      "sizl": true
    }
  ],
  "count": 1
}
```

---

## Pop (Battery Release)

### 17. Pop battery from a specific slot (1–6)

```bash
curl -X POST https://api.cuub.tech/pop/{station_id}/{slot}
```

**Example**

```bash
curl -X POST https://api.cuub.tech/pop/STATION001/3
```

**Expected response**

```json
{
  "success": true,
  "data": [
    {
      "slot": 3,
      "manufacture_id": "CUBH5A000513"
    }
  ],
  "count": 1
}
```

### 18. Pop all batteries from all slots (1–6)

```bash
curl -X POST https://api.cuub.tech/pop/{station_id}/all
```

**Expected response**

```json
{
  "success": true,
  "data": [
    {
      "slot": 1,
      "manufacture_id": "CUBH5A000501"
    },
    {
      "slot": 2,
      "manufacture_id": "CUBH5A000502"
    }
  ],
  "count": 2
}
```

---

## Rents

### 19. Fetch rent data for a station within a date range

Date range format: `YYYY-MM-DD_YYYY-MM-DD` (e.g., `2026-01-01_2026-01-31`)

```bash
curl -X GET https://api.cuub.tech/rents/{station_id}/{startDate}_{endDate}
```

**Example**

```bash
curl -X GET https://api.cuub.tech/rents/STATION001/2026-01-01_2026-01-31
```

**Expected response**

```json
{
  "success": true,
  "data": {
    "station_id": "STATION001",
    "dateRange": "2026-01-01_2026-01-31",
    "totalAmount": 45.50,
    "totalRents": 15
  }
}
```

---

## Token

### 20. Retrieve Energo API token

Performs login to Energo backend (with captcha solving via OpenAI), saves the token to the database, and returns it.

```bash
curl -X GET https://api.cuub.tech/token
```

**Expected response**

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Error responses**

- 401: Login failed (invalid credentials)
- 500: Missing env vars (`ENERGO_USERNAME`, `ENERGO_PASSWORD`, `OPENAI_API_KEY`) or token capture failure

---

## Stripe

### 21. List charges

Returns Stripe charges (`stripe.charges.list`), optionally filtered by date range. Requires `STRIPE_SECRET_KEY` to be set.

**Query parameters**

- `from` (optional): `YYYY-MM-DD` or `mtd` for month-to-date (first day of current month).
- `to` (optional): `YYYY-MM-DD`; defaults to today when `from` is set.
- `limit` (optional): default 10, max 100 when no date filter.

**Examples**

```bash
# Month to date (1st of current month through today)
curl "https://api.cuub.tech/stripe/charges?from=mtd"

# Specific range (e.g. Feb 1 – Feb 8, 2025)
curl "https://api.cuub.tech/stripe/charges?from=2025-02-01&to=2025-02-08"

# From a date to today (to omitted = today)
curl "https://api.cuub.tech/stripe/charges?from=2025-02-01"

# No date filter (uses limit only)
curl "https://api.cuub.tech/stripe/charges?limit=10"
```

**Expected response**

```json
{
  "success": true,
  "data": [ /* Stripe charge objects */ ],
  "has_more": false
}
```

### 22. List balance transactions

Returns Stripe balance transactions (`stripe.balanceTransactions.list`), optionally filtered by date range. Requires `STRIPE_SECRET_KEY` to be set.

**Query parameters**

- `from` (optional): `YYYY-MM-DD` or `mtd` for month-to-date (first day of current month).
- `to` (optional): `YYYY-MM-DD`; defaults to today when `from` is set.
- `limit` (optional): default 10, max 100 when no date filter.

**Examples**

```bash
# Month to date (1st of current month through today)
curl "https://api.cuub.tech/stripe/balance-transactions?from=mtd"

# Specific range (e.g. Feb 1 – Feb 8, 2025)
curl "https://api.cuub.tech/stripe/balance-transactions?from=2025-02-01&to=2025-02-08"

# From a date to today (to omitted = today)
curl "https://api.cuub.tech/stripe/balance-transactions?from=2025-02-01"

# No date filter (uses limit only)
curl "https://api.cuub.tech/stripe/balance-transactions?limit=10"
```

**Expected response**

```json
{
  "success": true,
  "data": [ /* Stripe balance transaction objects */ ],
  "has_more": false
}
```

### 23. Rents month-to-date

Returns per-day rent count and net sum from Stripe **balance transactions** for the current month to date (Chicago time). Uses `stripe/balance-transactions?from=mtd`. Filtered by `REVENUE_TYPES` (charge, payment, payment_refund, refund, payment_reversal, payment_failure_refund, stripe_fee, stripe_fx_fee, tax_fee). **positive** = sum of `net` where net > 0; **negative** = sum of `net` where net < 0; **money** per day = net sum; **rents** = count of `charge` with net > 0. Includes previous-month comparison (`ppositive`, `pnegative`, `prents`, `pmoney`).

```bash
curl -X GET https://api.cuub.tech/rents/mtd
```

**Expected response**

```json
{
  "success": true,
  "mtd": "Feb 1, 2026 – Feb 9, 2026",
  "positive": 426,
  "negative": -57,
  "ppositive": 380,
  "pnegative": -42,
  "data": [
    { "date": "Feb 1, 2026", "rents": 5, "money": "$15", "prents": 4, "pmoney": "$12" },
    { "date": "Feb 2, 2026", "rents": 6, "money": "$18", "prents": 5, "pmoney": "$15" }
  ]
}
```

### 24. Rents month-to-date by station

Returns month-to-date rents for one or more stations from Stripe **charges**, filtered by each station's Stripe customer ID. Uses `stripe/charges?from=mtd` filtered by `customer` (station's `stripe_id`). Stations are looked up in the `stations` table: `stations.stripe_id` maps to `charge.customer`. Same response format as `/rents/mtd`, with `station_ids` array.

**Endpoint:** `GET /rents/mtd/:station_id`

**Path parameters**

- `station_id` (required): One or more station IDs separated by `.` (e.g. `CUBT062510000029` or `CUBH242510000001.CUBT062510000029`). Must exist in `stations` table and have a non-null `stripe_id`.

**Example**

```bash
# Single station
curl -X GET https://api.cuub.tech/rents/mtd/CUBT062510000029

# Multiple stations (dot-separated)
curl -X GET https://api.cuub.tech/rents/mtd/CUBH242510000001.CUBT062510000029
```

**Expected response**

Same shape as **23. Rents month-to-date**, with `station_ids` array instead of `station_id`:

```json
{
  "success": true,
  "station_ids": ["CUBT062510000029"],
  "mtd": "Feb 1, 2026 – Feb 9, 2026",
  "positive": 120,
  "negative": -10,
  "ppositive": 95,
  "pnegative": -8,
  "data": [
    { "date": "Feb 1, 2026", "rents": 3, "money": "$9", "prents": 2, "pmoney": "$6" }
  ]
}
```

**Errors**

- `404`: No stations found or none have `stripe_id` configured (includes `requested` array of IDs).
- `400`: At least one `station_id` required, or station has no `stripe_id`.

### 25. Rents range

Aggregated rents for a date range. Includes previous-month comparison (`ppositive`, `pnegative`, `prents`, `pmoney`) for the same calendar span one month earlier, same as `/rents/mtd`. Correlates to `stripe/charges?from=YYYY-MM-DD&to=YYYY-MM-DD`. All dates in America/Chicago.

**Endpoint:** `GET /rents/range`

**Query parameters**

- `from` (required): `YYYY-MM-DD` start date.
- `to` (required): `YYYY-MM-DD` end date.

**Example**

```bash
curl "https://api.cuub.tech/rents/range?from=2025-02-01&to=2025-02-08"
```

**Expected response**

```json
{
  "success": true,
  "range": "Feb 1, 2025 – Feb 8, 2025",
  "positive": 120,
  "negative": -10,
  "ppositive": 95,
  "pnegative": -8,
  "data": [
    { "date": "Feb 1, 2025", "rents": 5, "money": "$15", "prents": 4, "pmoney": "$12" },
    { "date": "Feb 2, 2025", "rents": 6, "money": "$18", "prents": 5, "pmoney": "$15" }
  ]
}
```

### 26. Rents from (date to today)

Aggregated rents from a given date through today. Correlates to `stripe/charges?from=YYYY-MM-DD` (to omitted = today in Chicago).

**Endpoint:** `GET /rents/from`

**Query parameters**

- `from` (required): `YYYY-MM-DD` start date.

**Example**

```bash
curl "https://api.cuub.tech/rents/from?from=2025-02-01"
```

**Expected response**

Same shape as **23. Rents range** (e.g. `range`, `positive`, `negative`, `ppositive`, `pnegative`, `data` with `prents` and `pmoney` per day).

### 27. Rents recent (limit only)

Aggregated rents for the most recent N balance transactions, with no date filter. Correlates to `stripe/charges?limit=N`. Days in `data` are those that appear in the last N transactions.

**Endpoint:** `GET /rents/recent`

**Query parameters**

- `limit` (optional): number of balance transactions to include (default 10, max 100).

**Example**

```bash
curl "https://api.cuub.tech/rents/recent?limit=10"
```

**Expected response**

```json
{
  "success": true,
  "positive": 45,
  "negative": -3,
  "data": [
    { "date": "Feb 8, 2026", "rents": 2, "money": "$6" },
    { "date": "Feb 9, 2026", "rents": 1, "money": "$3" }
  ]
}
```
