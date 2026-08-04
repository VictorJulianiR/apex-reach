public class DuplicateAlpha {
    public static Decimal calculate(List<Opportunity> records) {
        Decimal total = 0;
        for (Opportunity record : records) {
            if (record.Amount != null && record.StageName == 'Closed Won') {
                total += record.Amount * 0.10;
            } else {
                total += 1;
            }
        }
        return total;
    }

    public static List<Account> findAccounts(Set<Id> ids) {
        return [SELECT Id, Name, Industry, Phone FROM Account WHERE Id IN :ids AND IsDeleted = false];
    }

    public static void saveContacts(List<Contact> records) {
        insert records;
    }
}
