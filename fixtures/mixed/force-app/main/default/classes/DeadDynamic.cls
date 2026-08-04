public class DeadDynamic {
    public static void lookup(String className) {
        Type.forName(className);
    }
}
