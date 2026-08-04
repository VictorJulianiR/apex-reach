public class BlockedHandler {
    public static void send(List<Contact> records) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint('callout:External');
        request.setMethod('POST');
        new Http().send(request);
    }
}
