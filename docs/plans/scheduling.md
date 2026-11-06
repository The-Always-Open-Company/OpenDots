# Scheduling

On 5 November the owner asked for a prepared Cliq message to be sent in an
hour. The Pod answered that it could not schedule a delayed message, and set
an action-item reminder for the owner instead.

## What was missing

- **No one-off schedule.** `propose_schedule` only repeated (on an interval or
  at calendar times), and every schedule waited for the owner to approve it.
- **The only one-off mechanism was hidden.** It was `upsert_responsibility`
  with a wake time. It is described as a responsibility, it repeats daily
  until closed, and since 14 October it has been loaded only on demand.
- **No way to approve an action now and run it later.** A scheduled run that
  sent a message would ask the owner to approve it again at that time.

## What the model has now

`schedule` and `list_schedules` are always loaded. `change_schedule` and
`cancel_schedule` appear once the Pod has a schedule.

`schedule(title, when, instructions | action, allowTools?)` does one of two
things.

**A task** (`instructions`). The Pod runs in the background each time and
posts its result in the chat.
- `allowTools` lists the plugin tools each run may use without asking, for
  example `plugin_zoho_ZohoCliq_send_message_to_chat` for a morning round of
  follow-up messages.
- A schedule with `allowTools` always goes to the owner as an approval card,
  even when the owner asked for it in chat, because it lets the Pod change
  things unattended. The card shows when it runs, its instructions, and the
  tools it may use.
- At run time the permission check allows those tools, and only for runs of
  that schedule's objective. Every other write still asks. A tool the owner
  later blocks for the Pod stays blocked.

**An action** (`action: { tool, arguments }`): one exact plugin call, such as
a set message.
- **Once:** a call that needs approval is approved now and waits in
  `pending_actions.notBefore` until its time. A call the Pod may already make
  is stored as approved.
- **Repeating:** the owner approves the schedule once. Each firing stores the
  call as approved and the action runner makes it, without the agent. Its
  outcome is posted in the chat. A repeating call the Pod may already make
  starts at once.

`when` is one of:
- `{ kind: "once", at | inMinutes }`
- `{ kind: "every", every, unit, startAt? }`, at most every 15 minutes
  (`minWakeIntervalMs`)
- `{ kind: "calendar", time: "HH:MM", weekdays?, timezone, until? }`

Times must carry a UTC offset, such as `2026-11-06T13:43:00-05:00`.

`list_schedules`, `change_schedule` and `cancel_schedule` manage every kind.
Cancelling also cancels the scheduled objective when nothing else runs it.

## Who decides

- **The owner asked in this turn:** a plain task, or an action the Pod may
  already make, takes effect at once. This covers chat, chat tasks and voice
  tasks.
- **An approval card is required for:** standing permission (`allowTools`), a
  repeating action that needs approval, and any schedule made outside the
  owner's conversation (a background run, a consultation, an approval
  outcome).
- **Declining a proposed schedule cancels it.** Before this change it reopened
  the objective and ran it once.

## Engine

- **A new `once` schedule kind.** It fires once and then disables its trigger.
  If its objective is busy or paused at that time, it tries again a minute
  later rather than being lost.
- **`claimApprovedAction`** skips approved actions whose `notBefore` is still
  in the future.
- **The approval-outcome turn** no longer has a five-minute limit.
