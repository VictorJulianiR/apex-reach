trigger BlockedAccountTrigger on Contact (after update) {
    BlockedHandler.send(Trigger.new);
}
