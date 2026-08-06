trigger RootTrigger on Account (before insert) {
    ConditionalResolver.run(String.valueOf(Trigger.operationType));
}
