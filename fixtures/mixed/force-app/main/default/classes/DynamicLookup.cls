public class DynamicLookup {
    public static void touch(String configuredClass) {
        Type implementation = Type.forName(configuredClass);
        System.debug(implementation);
    }
}
