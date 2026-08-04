public class AuraController {
    @AuraEnabled
    public static void invoked() {
        System.debug('called from Aura');
    }

    @AuraEnabled
    public static void orphan() {
        System.debug('not called from Aura');
    }
}
