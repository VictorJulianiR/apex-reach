trigger MetadataRootTrigger on Account (before insert) {
    MetadataTypeResolver.runConfiguredService();
    MetadataTypeResolver.runAssignedService();
    MetadataTypeResolver.runGetInstanceService();
    MetadataTypeResolver.runGetAllServices();
    MetadataTypeResolver.runSelectorService();
    MetadataTypeResolver.runHelperService();
}
