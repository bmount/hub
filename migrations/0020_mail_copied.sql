-- Who else a received message was addressed to (owner, 2026-10-08): the To and Cc addresses, lowercased, as a JSON
-- array, without the hub's own addresses or the sender. An agent may write to members who wrote to it or whom a
-- member copied on a message to it, so this is what "copied" is checked against.
ALTER TABLE inbound_mail ADD COLUMN copied TEXT;
