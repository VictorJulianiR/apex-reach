public class AccountHandler {
    public static void run(List<Account> records) {
        new AccountHandler().dispatch(records.size());
    }

    private void dispatch(Integer count) {
        this.helper(count);
    }

    private void helper(Integer count) {
        System.debug(count);
    }

    private static void orphan() {
        System.debug('not called');
    }
}
