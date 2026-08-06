trigger AccountTrigger on Account (before insert) {
    AccountHandler.run(Trigger.new);
    DynamicLookup.touch(String.valueOf(Trigger.operationType));
}
