public class MetadataTypeSelector {
    public List<Service_Config__mdt> loadServices() {
        return loadServicesInternal();
    }

    private List<Service_Config__mdt> loadServicesInternal() {
        return [SELECT HelperClassName__c FROM Service_Config__mdt];
    }
}
