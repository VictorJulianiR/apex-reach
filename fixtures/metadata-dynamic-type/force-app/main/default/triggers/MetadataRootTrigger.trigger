trigger MetadataRootTrigger on Account (before insert) {
    MetadataTypeResolver.runConfiguredService();
}
