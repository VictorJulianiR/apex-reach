public class MetadataTypeResolver {
    public static void runConfiguredService() {
        List<Service_Config__mdt> services = [
            SELECT HelperClassName__c
            FROM Service_Config__mdt
        ];
        Type.forName(services.get(0).HelperClassName__c).newInstance();
    }

    public static void runInjectedService(List<Service_Config__mdt> services) {
        Type.forName(services.get(0).HelperClassName__c).newInstance();
    }
}
