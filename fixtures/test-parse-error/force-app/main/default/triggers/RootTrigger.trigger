trigger RootTrigger on Account (before insert) {
    LiveHandler.run();
}
