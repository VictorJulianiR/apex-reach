import { LightningElement } from 'lwc';
import load from '@salesforce/apex/UiController.load';

export default class AccountPanel extends LightningElement {
    connectedCallback() {
        load();
    }
}
