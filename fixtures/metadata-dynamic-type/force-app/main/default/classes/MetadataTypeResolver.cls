public class MetadataTypeResolver {
    public static void runConfiguredService() {
        List<Service_Config__mdt> services = [
            SELECT HelperClassName__c
            FROM Service_Config__mdt
        ];
        Type.forName(services.get(0).HelperClassName__c).newInstance();
    }

    public static void runAssignedService() {
        List<Service_Config__mdt> services;
        services = [SELECT HelperClassName__c FROM Service_Config__mdt];
        Type.forName(services[0].HelperClassName__c).newInstance();
    }

    public static void runGetInstanceService() {
        Service_Config__mdt service = Service_Config__mdt.getInstance('Default');
        Type.forName(service.HelperClassName__c).newInstance();
    }

    public static void runGetAllServices() {
        List<Service_Config__mdt> services = Service_Config__mdt.getAll().values();
        Type.forName(services.get(0).HelperClassName__c).newInstance();
    }

    public static void runSelectorService() {
        MetadataTypeSelector selector = new MetadataTypeSelector();
        List<Service_Config__mdt> services = selector.loadServices();
        Type.forName(services.get(0).HelperClassName__c).newInstance();
    }

    public static void runHelperService() {
        List<Service_Config__mdt> services = [SELECT HelperClassName__c FROM Service_Config__mdt];
        instantiate(services.get(0).HelperClassName__c);
        instantiate('ConfiguredService');
    }

    private static void instantiate(String className) {
        Type.forName(className).newInstance();
    }

    public static void runInjectedService(List<Service_Config__mdt> services) {
        Type.forName(services.get(0).HelperClassName__c).newInstance();
    }
}
