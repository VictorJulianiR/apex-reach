public class DynamicLookup {
    public static void touch(String className) {
        Type.forName(className);
    }
}
