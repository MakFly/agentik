goal: wire the billing export

- learned (verified against the vendor docs, not written anywhere in this repo): the Acme billing API rate limit is 600 requests per minute per token, and it returns HTTP 429 with a Retry-After header. Applies to every project that talks to Acme.
- status: completed
