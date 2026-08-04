public class ExposedOnly {
    @AuraEnabled
    public static void auraMethod() {
        System.debug('callable is not called');
    }

    @InvocableMethod(label='Unused')
    public static void flowMethod(List<String> inputs) {
        System.debug(inputs);
    }

    @future
    public static void asyncMethod() {
        System.debug('future still needs a caller');
    }
}
