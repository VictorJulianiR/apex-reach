public class UiController {
    public static String load() {
        return 'loaded';
    }

    private static void orphanUiMethod() {
        System.debug('candidate');
    }
}
