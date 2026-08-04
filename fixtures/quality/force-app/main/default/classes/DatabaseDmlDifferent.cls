public class DatabaseDmlDifferent {
    public static void partial(List<Account> accounts) {
        Database.insert(accounts, false);
    }
}
