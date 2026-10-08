---
name: tidy
description: Tidy the user's Virlow memories - link unlinked memories, merge duplicate names and resolve conflicting facts with memory_health. Use when the user asks to tidy, clean up, organize or check the health of their Virlow memories.
---

# Tidy Virlow memories

Tidy the user's Virlow memories, following the virlow-memory skill:

1. Call `memory_health` (no namespace, so it covers everything).
2. Call `list_memories` with `unlinked_only: true`. For each memory it lists,
   call `link_memory` with the entities it is about and any relations it
   states. Repeat until it lists none, or only memories that name nothing
   worth linking.
3. For each possible duplicate name, merge with `merge_entities` only when
   the memories make it clear they are the same person or thing; otherwise
   leave them.
4. For each conflicting fact, work out which is current from the memories
   and end the older one with `update_memory` and `valid_to` (the date it
   stopped being true). Never delete it; it is history.
5. Finish with a short summary: how many memories linked, names merged,
   conflicts resolved, and anything you were unsure about.

Change only links, names and end dates. Do not rewrite what a memory says,
and do not add new memories while tidying. If a tool says the vault is
locked, call `unlock`, tell the user to finish in the browser form it opens,
and stop until they have.
