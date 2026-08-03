public class AccountHandler {
    public static void run(List<Account> records) {
        helper(records.size());
    }

    private static void helper(Integer count) {
        System.debug(count);
    }

    private static void orphan() {
        System.debug('not called');
    }
}
