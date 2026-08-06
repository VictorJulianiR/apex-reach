public class ConditionalResolver {
    public static void run(String injectedName) {
        List<Service_Config__mdt> services = [
            SELECT HelperClassName__c
            FROM Service_Config__mdt
        ];
        String className = services[0].HelperClassName__c;
        if (Trigger.isInsert) {
            className = injectedName;
        }
        Type.forName(className).newInstance();
    }
}
