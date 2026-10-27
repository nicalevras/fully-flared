# Customers in the admin: identity and privacy contract

This document is the contract for Phase 10. It was written before the
implementation in the same pull request, and the code follows it.

## Two kinds of purchase record

- An account order belongs to a signed-in shopper. It carries `user_id`.
- A guest order was placed without an account. It has no `user_id`. It is
  identified only by the email typed at checkout.

These are different records even when the email text is identical. Matching
an account email never grants the account ownership of guest orders, never
shows guest orders inside the account history, and never merges the two
histories into one person.

## Email matching

Matching trims surrounding whitespace and folds letter case. Nothing else is
rewritten. Dots, plus tags, and provider specific rules are never applied,
because the store cannot know whether two such addresses reach the same
mailbox.

## What staff can see

- Lookup by email returns counts first: whether an account exists, how many
  account orders it has, and how many guest orders carry that email.
- Order history loads only when a staff member opens that contact.
- Account order history is every order whose `user_id` is the account, even
  if the email on an older order differs after an account email change.
- Guest history is only orders with no `user_id` and a matching email.
- Both lists are bounded. No unbounded history query is permitted.

## Export and erasure

- Account export and deletion keep their existing scope. Deleting an account
  never expands silently to guest purchases made with the same email.
- Guest export is an owner authorized operation. Guest erasure is withheld
  from this release and disabled server-side: no role, including owner, can
  invoke it. The erasure implemented earlier did not cover every store of a
  guest email (notably notification outbox payloads), and no retention
  contract for those stores has been approved. Erasure returns only after a
  written retention contract covers outbox payloads, checkout and
  reservation records, exports, stored files, and external systems.
- Guest export and erasure are separate, owner authorized operations with a
  preview of the exact affected records before anything runs.
- Financial facts that the store must retain, such as order totals, tax, and
  refund records, stay retained. Erasure removes identifying details, and the
  retained facts are explained in the preview before erasure runs.

## Staff are not shoppers

Staff accounts carry roles that grant admin access. Customer support views
show shoppers. Staff management is presented separately so a role change is
never mistaken for a shopper edit.
