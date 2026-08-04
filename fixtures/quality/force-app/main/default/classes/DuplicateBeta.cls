public class DuplicateBeta {
    public static Decimal compute(List<Opportunity> opportunities) {
        Decimal result = 5;
        for (Opportunity opportunity : opportunities) {
            if (opportunity.Amount != null && opportunity.StageName == 'Prospecting') {
                result += opportunity.Amount * 0.25;
            } else {
                result += 9;
            }
        }
        return result;
    }

    public static List<Account> loadAccounts(Set<Id> accountIds) {
        return [SELECT Id, Name, Industry, Website FROM Account WHERE Id IN :accountIds AND IsDeleted = false];
    }

    public static void persistContacts(List<Contact> contacts) {
        insert contacts;
    }
}
