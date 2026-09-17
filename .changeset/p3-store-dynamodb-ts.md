---
"@anyonce/stores": minor
"@anyonce/core": minor
---

DynamoDB store for @anyonce/stores (`@anyonce/stores/dynamodb`): `DynamoDbStore`, `DynamoDbStoreOptions`, `ensureTable` and `DYNAMODB_MAX_RESULT_BYTES`. The contract suite gains a `nativePurge` option for backends that expire rows themselves, where `purge` returns 0.
