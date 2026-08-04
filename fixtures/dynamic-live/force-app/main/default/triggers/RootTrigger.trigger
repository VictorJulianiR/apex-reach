trigger RootTrigger on Account (before insert) {
    DynamicLookup.touch(String.valueOf(Trigger.operationType));
}
