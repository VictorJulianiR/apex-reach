trigger SimpleAccountTrigger on Account (before update) {
    SimpleAccountHandler.apply(Trigger.new);
}
