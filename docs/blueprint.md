# GroupGuard Moderation Bot — Bot specification

**Archetype:** community

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

Automates group moderation with human verification, spam detection, admin commands, and transparent actions. Greet new members, enforce rules, and maintain logs while ensuring transparency for all moderation decisions.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Telegram group owners
- Admins managing community groups

## Success criteria

- Reduces spam accounts by 90% within 24 hours
- Maintains 100% transparency in automated moderation actions
- Achieves 30-second verification response time for new members

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open admin configuration menu
- **I am human** (button, actor: user, callback: verify:confirm) — Verify new member identity
  - inputs: user_id, join_time
  - outputs: verification status
- **/setrules** (command, actor: admin, command: /setrules) — Configure spam detection rules
- **/trust** (command, actor: admin, command: /trust) — Add user to trust list

## Flows

### New member verification
_Trigger:_ user_join

1. Send welcome message with verification button
2. Wait 30 seconds for button tap
3. Remove unverified users with explanation

_Data touched:_ Member, Newcomer verification

### Spam detection
_Trigger:_ message_post

1. Check against spam rules (age, keywords, flood)
2. Apply configured action (warn/mute/kick)
3. Post explanation message

_Data touched:_ Spam rule set, Admin action log

### Admin command handling
_Trigger:_ /command

1. Execute moderation action
2. Log action with timestamp
3. Post confirmation message

_Data touched:_ Admin action log, Trust list

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Member** _(retention: persistent)_ — Group participant tracking
  - fields: user_id, join_time, verified_status
- **Spam rule set** _(retention: persistent)_ — Configurable spam detection parameters
  - fields: link_age_threshold, keyword_list, flood_limit, repeat_window
- **Admin action log** _(retention: persistent)_ — Moderation history
  - fields: action_type, target_user, reason, timestamp

## Integrations

- **Telegram** (required) — Bot API messaging and group management
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Configure welcome message text
- Adjust spam detection thresholds
- Manage trust list
- Enable/disable automatic actions
- Set report frequency (daily/weekly)

## Notifications

- In-group moderation explanations
- Admin summary reports (daily/weekly)

## Permissions & privacy

- Never acts on admin accounts
- Excludes pinned messages from moderation
- Requires explicit opt-in for group-specific settings

## Edge cases

- Users joining and leaving before verification
- Conflicting spam rule triggers
- Multiple simultaneous admin commands

## Required tests

- Verify 30-second timeout removes unverified users
- Test all spam rule combinations trigger correct actions
- Validate admin command logging and in-group notifications

## Assumptions

- Default 24-hour link age threshold covers most spam
- Weekly summary reports provide sufficient oversight
- Button-based verification is more reliable than text commands
